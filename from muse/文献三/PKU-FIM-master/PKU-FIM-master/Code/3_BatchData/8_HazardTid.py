# -*-coding:utf-8 -*-
# python 2.7
# 把灾点和网格关联起来，提取受灾的网格

"""
# @File       : 8_HazardTid.py
# @software   : PyCharm  
# @Time       ：2024/6/24 19:23
# @Author     ：Wei Lyu
"""

import pandas as pd
import arcpy
# import time

arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Spatial")

if __name__ == '__main__':
    path = r'D:\LW\ABM\Data\cities_21'
    outputPath = r'D:\LW\ABM\OutputData\cities_21'

    ws_path = path + r'\map_WS_21\map_WS_21.gdb'
    zsPath = path + r'\ZS_DEM'


    relation = pd.read_csv(outputPath + '\\' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3])
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()


    # for city_en in cities_en[5:]:
        # ZS转栅格
    city_en = cities_en[0]
    ind = cities_en.index(city_en)
    city_cn = cities_cn[ind]

    city_grid = outputPath + '\\' + city_cn + '\\' + city_cn + '_grid.shp'
    zsdem = zsPath + '\\' + city_en + '_ZSDEM.dbf'
    ws = ws_path + '\\' + city_en + '_wsf'

    # join data
    arcpy.MakeFeatureLayer_management(ws, "temp_layer")
    arcpy.AddJoin_management("temp_layer", 'OBJECTID', zsdem, 'OBJECTID')
    ws_zsdem = outputPath + '\\' + city_cn + '\\' + city_en + '_WS_ZSDEM.shp'
    arcpy.CopyFeatures_management("temp_layer", ws_zsdem)

    fields = arcpy.ListFields(ws_zsdem)

    # 转栅格
    ws_drown = outputPath + '\\' + city_cn + '\\' + city_en + "_ws_drown.tif"
    arcpy.conversion.PolygonToRaster(
        in_features=ws_zsdem,
        value_field=fields[-1].name,
        out_rasterdataset=ws_drown,
        cell_assignment="CELL_CENTER",
    )
    arcpy.Delete_management(ws_zsdem)

    table = outputPath + '\\' + city_cn + '\\' + city_en + "_grid_drown.dbf"
    arcpy.sa.ZonalStatisticsAsTable(city_grid, 'Tid', ws_drown, table, "NODATA", "MAXIMUM")

    # 获取字段信息
    fields = ['Tid', 'MAX']
    # 打开 CSV 文件并写入
    output_xls = outputPath + '\\' + city_cn + '\\' + city_en + "_grid_drown_max.xls"
    output_xls2 = outputPath + '\\' + 'cities_grid_drown_max' + '\\' + city_en + "_grid_drown_max.xls"

    data = []

    #stop
    cursor = arcpy.da.SearchCursor(table, fields)

    # stop
    for row in cursor:
        data.append(row)

    del cursor

    # 将数据转换为 DataFrame
    df = pd.DataFrame(data, columns=fields)

    # 导出为 Excel 文件
    df.to_excel(output_xls, index=False, encoding='utf-8', header=True)
    df.to_excel(output_xls2, index=False, encoding='utf-8', header=True)

    # arcpy.Delete_management(ws_drown)
    arcpy.Delete_management(table)
