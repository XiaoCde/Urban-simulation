# -*-coding:utf-8 -*-

"""
# @File       : 5_Shelter_sj_Cali&Vali(sz).py
# @software   : PyCharm  
# @Time       ：2025/3/26 17:53
# @Author     ：Wei Lyu
"""

import pandas as pd
import arcpy

if __name__ == '__main__':
    outputPath = 'D:/LW/ABM/OutputData'

    city = 'shenzhen'
    city_path = outputPath + '/' + city
    fc = city + '_real_shelter.shp'

    # file = city_path + '/poi2018_shelters_shenzhen.csv'
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
    # cursor = arcpy.da.InsertCursor(city_path + '/' + fc, ["SHAPE@X", "SHAPE@Y", "省", "市", "区_县", "场所名", "地址", "is_poi", "lng", "lat"])
    # # stop
    # for i, r in shelter_text.iterrows():
    #     if type(r[0]) != str:
    #         r[0] = ''
    #     if type(r[1]) != str:
    #         r[1] = ''
    #     if type(r[6]) != str:
    #         r[6] = ''
    #     row = (float(r[11]), float(r[12]), u'广东省', u'深圳市', r[1], r[6], r[0], u'是', float(r[11]), float(r[12]))
    #     cursor.insertRow(row)
    #     # break
    # del cursor
    #
    # sr = arcpy.SpatialReference(4326)
    # arcpy.DefineProjection_management(city_path + '/' + fc, sr)

    shelter = city_path + '/' + fc
    # grid = 'D:/LW/ABM/Data/shenzhen/大湾区&深圳市shp/大湾区&深圳市网格shp(051_地级市区县)/深圳市1km网格.shp'

    # granularity = '1km'
    # granularity = '2km'
    granularity = '3km'
    grid = 'D:/LW/ABM/Data/shenzhen/sz_tid_'+granularity+'/sz_tid_' + granularity+'.shp'

    out_feature_class = city_path + '/' + city + '_shelter_tid_' + granularity + '.shp'
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