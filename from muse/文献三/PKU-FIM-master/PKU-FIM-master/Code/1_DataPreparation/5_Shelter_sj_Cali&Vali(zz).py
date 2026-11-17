# -*-coding:utf-8 -*-
# 把筛选出的shelter空间关联到Tid中（zhengzhou）

"""
# @File       : 5_Shelter_sj_Cali&Vali(zz).py
# @software   : PyCharm  
# @Time       ：2025/3/26 10:34
# @Author     ：Wei Lyu
"""

import pandas as pd
import arcpy

if __name__ == '__main__':
    outputPath = 'D:/LW/ABM/OutputData'

    city = 'zhengzhou'
    city_path = outputPath + '/' + city
    fc = city + '_real_shelter.shp'

    # # 第一份 2021年shelter POI数据
    # file = city_path + '/poi2021_shelters_zhengzhou.csv'
    # shelter_text = pd.read_csv(file, header=0)
    #
    # # 去重 去除空值
    # shelter_text.drop_duplicates(subset=['longitude', 'latitude'], inplace=True)
    # # 去除空值
    # shelter_text.dropna(subset=['longitude', 'latitude'], inplace=True)
    # arcpy.CreateFeatureclass_management(city_path, fc, "POINT")
    # arcpy.AddField_management(city_path + '/' + fc, "省", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "市", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "区_县", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "场所名", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "地址", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "经度", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "纬度", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "is_poi", "TEXT")
    # arcpy.AddField_management(city_path + '/' + fc, "lng", "FLOAT")
    # arcpy.AddField_management(city_path + '/' + fc, "lat", "FLOAT")
    # cursor = arcpy.da.InsertCursor(city_path + '/' + fc, ["SHAPE@X", "SHAPE@Y", "省", "市", "区_县",
    #                                                       "场所名", "地址", "is_poi", "lng", "lat"])
    # 
    # for i, r in shelter_text.iterrows():
    #     if type(r[7]) != str:
    #         r[7] = ''
    #     if type(r[10]) != str:
    #         r[10] = ''
    #     row = (float(r[16]), float(r[17]), u'河南省', u'郑州市', u' ', r[7], r[10], u'是', float(r[16]), float(r[17]))
    #     cursor.insertRow(row)
    #     # break
    # del cursor
    #
    #
    # # 第二份数据 2019年数据
    # file = city_path + '/zhengzhou2019_real_shelter_part.csv'
    # shelter_text = pd.read_csv(file, header=0)
    # # 去重 去除空值
    # shelter_text.drop_duplicates(subset=['lng', 'lat'], inplace=True)
    # # 去除空值
    # shelter_text.dropna(subset=['lng', 'lat'], inplace=True)
    #
    # cursor = arcpy.da.InsertCursor(city_path + '/' + fc, ["SHAPE@X", "SHAPE@Y", "省", "市", "区_县",
    #                                                       "场所名", "地址", "is_poi", "lng", "lat"])
    #
    # for i, r in shelter_text.iterrows():
    #     if type(r[1]) != str:
    #         r[1] = ''
    #     if type(r[6]) != str:
    #         r[6] = ''
    #     row = (float(r[14]), float(r[15]), u'河南省', u'郑州市', u'', r[1], r[6], u'', float(r[14]), float(r[15]))
    #     cursor.insertRow(row)
    #     # break
    # del cursor
    #
    # sr = arcpy.SpatialReference(4326)
    # arcpy.DefineProjection_management(city_path + '/' + fc, sr)

    shelter = city_path + '/' + fc
    # grid = 'D:/LW/ABM/Data/zhengzhou/studyarea_tid/studyarea_tid.shp'

    # granularity = '1km'
    # granularity = '2km'
    granularity = '3km'
    grid = 'D:/LW/ABM/Data/zhengzhou/zz_tid_' + granularity + '/zz_tid_' + granularity + '.shp'


    out_feature_class = city_path + '/' + city + '_shelter_tid_'+ granularity +'.shp'
    arcpy.SpatialJoin_analysis(shelter, grid, out_feature_class)  # 如果shelter有些points超出边界，则无法关联上

    output_csv = city_path + '/shelter_tid_' + granularity + '.csv'
    data = []

    cursor = arcpy.da.SearchCursor(out_feature_class, ['FID', 'Join_Count', 'Tid'])

    for row in cursor:
        if row[1] != 0:
            data.append(row)
    del cursor
    # 将数据转换为 DataFrame
    df = pd.DataFrame(data, columns=['ID', 'Join_Count', 'Tid'])
    df.drop('Join_Count', axis=1, inplace=True)
    # 导出为 Excel 文件
    df.to_csv(output_csv, index=False, encoding='utf-8', header=True)
    arcpy.Delete_management(out_feature_class)
