# -*-coding:utf-8 -*-
# python 2.7
# 把shelter文本转成shp，再把shp空间连接到每个tid上，再导出xls

"""
# @File       : 2_Shelter_sj.py
# @software   : PyCharm  
# @Time       ：2024/6/16 11:20
# @Author     ：Wei Lyu
"""

import arcpy
import pandas as pd


arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Spatial")

if __name__ == '__main__':

    outputPath = 'D:/LW/ABM/OutputData/cities_21'

    relation = pd.read_csv(outputPath + '/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3])
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    # for city in cities_cn:
    city = cities_cn[20]
    city_path = outputPath + '/' + city
    file = outputPath + '/' + city + '/' + city + '_real_shelter.csv'
    shelter_text = pd.read_csv(file, header=0)
    # 去重。去除空值
    shelter_text.drop_duplicates(subset=['lng', 'lat'], inplace=True)
    # 去除空值
    shelter_text.dropna(subset=['lng', 'lat'], inplace=True)
    fc = city + '_real_shelter.shp'
    arcpy.CreateFeatureclass_management(city_path, fc, "POINT")
    arcpy.AddField_management(city_path + '/' + fc, "省", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "市", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "拼音", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "区_县", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "街道_镇", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "场所名", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "地址", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "经度", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "纬度", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "is_poi", "TEXT")
    arcpy.AddField_management(city_path + '/' + fc, "lng", "FLOAT")
    arcpy.AddField_management(city_path + '/' + fc, "lat", "FLOAT")
    cursor = arcpy.da.InsertCursor(city_path + '/' + fc, ["SHAPE@X", "SHAPE@Y", "省", "市", "拼音", "区_县", "街道_镇",
                                                          "场所名", "地址", "经度", "纬度", "is_poi", "lng", "lat"])
    # stop
    for i, r in shelter_text.iterrows():
        if type(r[3]) != str:
             r[3] = ''
        if type(r[4]) != str:
             r[4] = ''
        if type(r[5]) != str:
             r[5] = ''
        if type(r[6]) != str:
             r[6] = ''
        if type(r[7]) != str:
             r[7] = ''
        if type(r[8]) != str:
             r[8] = ''
        if type(r[9]) != str:
             r[9] = ''
        row = (float(r[10]), float(r[11]), r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], float(r[10]), float(r[11]))
        cursor.insertRow(row)
        # break
    del cursor

    sr = arcpy.SpatialReference(4326)
    arcpy.DefineProjection_management(city_path + '/' + fc, sr)

    shelter = city_path + '/' + fc
    grid = city_path + '/' + city + '_grid.shp'

    out_feature_class = city_path + '/' + city + '_shelter_tid.shp'
    arcpy.SpatialJoin_analysis(shelter, grid, out_feature_class)    # 如果shelter有些points超出边界，则无法关联上

    output_xls = city_path + '/shelter_tid.xls'
    data = []
    # stop
    cursor = arcpy.da.SearchCursor(out_feature_class, ['FID', 'Join_Count', 'Tid'])
    # stop
    for row in cursor:
        if row[1] != 0:
            data.append(row)
    del cursor
    # 将数据转换为 DataFrame
    df = pd.DataFrame(data, columns=['ID', 'Join_Count', 'Tid'])
    df.drop('Join_Count', axis=1, inplace=True)
    # 导出为 Excel 文件
    df.to_excel(output_xls, index=False, encoding='utf-8', header=True)
    arcpy.Delete_management(out_feature_class)